package org.setbd.parentcontrol.webrtc

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.Camera2Enumerator
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoCapturer
import org.webrtc.VideoSource
import org.webrtc.VideoTrack

/**
 * WebRTC peer for child→parent media sessions (screen / camera / microphone).
 *
 * Design:
 *  * One active session at a time (the consent model makes concurrent capture
 *    sessions confusing for the child; the parent dashboard enforces this too).
 *  * Signaling rides Firestore via [SignalingClient]; the child posts the
 *    OFFER, the parent answers, ICE candidates flow both ways.
 *  * TURN/STUN: ICE configuration (including EPHEMERAL, session-scoped TURN
 *    credentials) is fetched from the session document at connect time —
 *    issued per-session by the requestSession Cloud Function (coturn REST
 *    scheme). SECURITY (audit fix): credentials are NEVER compiled into the
 *    app; if no relay is configured we fall back to STUN-only.
 */
class WebRtcClient(private val context: Context) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val eglBase: EglBase by lazy { EglBase.create() }
    private val factory: PeerConnectionFactory by lazy { buildFactory() }

    private var peerConnection: PeerConnection? = null
    private var signaling: SignalingClient? = null
    private var videoSource: VideoSource? = null
    private var audioSource: AudioSource? = null
    private var videoCapturer: VideoCapturer? = null
    private var surfaceHelper: SurfaceTextureHelper? = null
    private var sessionId: String? = null

    /** Tracks what kind of media the current session carries. */
    @Volatile
    var activeKind: String? = null
        private set

    /** Listener for UI/session managers (e.g. to stop when ICE fails hard). */
    var onSessionEnded: ((sessionId: String) -> Unit)? = null

    // ------------------------------------------------------------- lifecycle --

    /**
     * Starts a session. `capturer` may be null for audio-only sessions.
     * @param kind one of "SCREEN" | "CAMERA" | "AUDIO"
     */
    fun startSession(sessionId: String, kind: String, capturer: VideoCapturer?) {
        stopSessionInternal(cleanupSignaling = false)
        this.sessionId = sessionId
        activeKind = kind

        val signalingClient = SignalingClient()
        signaling = signalingClient

        scope.launch {
            // Server-issued per-session ICE config (ephemeral TURN when the
            // deployment has a relay; STUN-only otherwise).
            val iceServers = buildIceServers(signalingClient.fetchIceServers(sessionId))
            val config = PeerConnection.RTCConfiguration(iceServers).apply {
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            }

            val pc = factory.createPeerConnection(config, peerObserver) ?: return@launch
            peerConnection = pc

            // --- local tracks ------------------------------------------------
            if (capturer != null) {
                val source = factory.createVideoSource(isScreencast = kind == "SCREEN")
                videoSource = source
                val helper = SurfaceTextureHelper.create("fs-capture", eglBase.eglBaseContext)
                surfaceHelper = helper
                capturer.initialize(helper, context, source.capturerObserver)
                // Resolution/fps: modest defaults keep a child device cool.
                capturer.startCapture(1280, 720, if (kind == "SCREEN") 15 else 24)
                videoCapturer = capturer
                val track: VideoTrack = factory.createVideoTrack("$kind-video", source)
                pc.addTrack(track, listOf(STREAM_ID))
            }

            if (kind != "SCREEN") { // audio for AUDIO/CAMERA sessions
                val aSource = factory.createAudioSource(MediaConstraints())
                audioSource = aSource
                val aTrack: AudioTrack = factory.createAudioTrack("$kind-audio", aSource)
                pc.addTrack(aTrack, listOf(STREAM_ID))
            }

            // --- signaling handshake -----------------------------------------
            signalingClient.openSession(sessionId, kind)
            signalingClient.listen(sessionId, ::onRemoteSignal)
            createAndSendOffer(sessionId)
        }
    }

    /**
     * Maps the server-issued ICE config (session doc `iceServers` field) to
     * PeerConnection.IceServer objects. Google STUN is always included as the
     * baseline; TURN entries are appended exactly as issued (they already
     * carry time-limited HMAC credentials).
     */
    private fun buildIceServers(configs: List<Map<String, Any?>>): List<PeerConnection.IceServer> {
        val servers = mutableListOf(
            PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
        )
        for (cfg in configs) {
            val urls = when (val u = cfg["urls"]) {
                is String -> listOf(u)
                is List<*> -> u.filterIsInstance<String>()
                else -> emptyList()
            }
            val username = cfg["username"] as? String
            val credential = cfg["credential"] as? String
            for (url in urls) {
                val builder = PeerConnection.IceServer.builder(url)
                if (!username.isNullOrBlank()) builder.setUsername(username)
                if (!credential.isNullOrBlank()) builder.setPassword(credential)
                servers.add(builder.createIceServer())
                break // one URL per issued entry is sufficient
            }
        }
        return servers
    }

    /** Full teardown: capture, tracks, peer connection and session doc. */
    fun stopSession() {
        stopSessionInternal(cleanupSignaling = true)
    }

    private fun stopSessionInternal(cleanupSignaling: Boolean) {
        val sid = sessionId
        val signalingClient = signaling
        try {
            videoCapturer?.stopCapture()
        } catch (e: Exception) {
            // Capturer already stopped or thread interrupted — safe to ignore.
        }
        videoCapturer?.dispose(); videoCapturer = null
        surfaceHelper?.dispose(); surfaceHelper = null
        videoSource?.dispose(); videoSource = null
        audioSource?.dispose(); audioSource = null
        peerConnection?.close()
        peerConnection?.dispose()
        peerConnection = null
        activeKind = null
        sessionId = null
        if (cleanupSignaling && sid != null && signalingClient != null) {
            scope.launch {
                signalingClient.closeSession(sid)
                onSessionEnded?.invoke(sid)
            }
        }
        signaling = null
    }

    // -------------------------------------------------------------- signaling --

    private fun createAndSendOffer(sessionId: String) {
        val pc = peerConnection ?: return
        pc.createOffer(
            object : SdpObserver by noop {
                override fun onCreateSuccess(desc: SessionDescription) {
                    pc.setLocalDescription(noop, desc)
                    scope.launch { signaling?.sendOffer(sessionId, desc.description) }
                }
            },
            MediaConstraints(),
        )
    }

    private fun onRemoteSignal(signal: Signal) {
        val pc = peerConnection ?: return
        val sid = sessionId ?: return
        when (signal.kind) {
            "answer" -> signal.sdp?.let {
                pc.setRemoteDescription(
                    noop,
                    SessionDescription(SessionDescription.Type.ANSWER, it),
                )
            }
            "candidate" -> signal.candidateSdp?.let {
                pc.addIceCandidate(
                    IceCandidate(signal.sdpMid, signal.sdpMLineIndex ?: 0, it),
                )
            }
            "bye" -> {
                scope.launch { signaling?.closeSession(sid) }
                onSessionEnded?.invoke(sid)
                stopSessionInternal(cleanupSignaling = false)
            }
        }
    }

    private val peerObserver = object : PeerConnection.Observer {
        override fun onIceCandidate(candidate: IceCandidate) {
            val sid = sessionId ?: return
            scope.launch {
                signaling?.sendCandidate(sid, candidate.sdp, candidate.sdpMid, candidate.sdpMLineIndex)
            }
        }

        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
            if (state == PeerConnection.IceConnectionState.FAILED ||
                state == PeerConnection.IceConnectionState.CLOSED
            ) {
                // Parent gone / network dead: end the session so the visible
                // indicator never outlives the actual stream.
                val sid = sessionId
                if (sid != null) {
                    scope.launch {
                        signaling?.closeSession(sid)
                        onSessionEnded?.invoke(sid)
                    }
                    stopSessionInternal(cleanupSignaling = false)
                }
            }
        }

        override fun onSignalingChange(state: PeerConnection.SignalingState) {}
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
        override fun onAddStream(stream: org.webrtc.MediaStream) {}
        override fun onRemoveStream(stream: org.webrtc.MediaStream) {}
        override fun onDataChannel(channel: org.webrtc.DataChannel) {}
        override fun onRenegotiationNeeded() {}
        override fun onTrack(transceiver: org.webrtc.RtpTransceiver) {}
        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {}
    }

    // ---------------------------------------------------------------- factory --

    private fun buildFactory(): PeerConnectionFactory {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context.applicationContext)
                .setEnableInternalTracer(false)
                .createInitializationOptions(),
        )
        return PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
            .createPeerConnectionFactory()
    }

    /** Convenience: front-facing camera capturer (camera sessions). */
    fun createFrontCameraCapturer(): VideoCapturer? {
        val enumerator = Camera2Enumerator(context)
        val name = enumerator.deviceNames.firstOrNull { enumerator.isFrontFacing(it) }
            ?: enumerator.deviceNames.firstOrNull()
            ?: return null
        return enumerator.createCapturer(name, null)
    }

    private companion object {
        const val STREAM_ID = "familysafety-child"
        val noop = object : SdpObserver {
            override fun onCreateSuccess(desc: SessionDescription?) {}
            override fun onSetSuccess() {}
            override fun onCreateFailure(error: String?) {}
            override fun onSetFailure(error: String?) {}
        }
    }
}
