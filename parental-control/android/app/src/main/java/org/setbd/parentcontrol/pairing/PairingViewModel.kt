package org.setbd.parentcontrol.pairing

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn

/**
 * Thin ViewModel exposing [PairingManager] state to [PairingScreen].
 * Keeping business logic in the manager lets the FCM / command paths reuse it.
 */
class PairingViewModel(
    private val pairingManager: PairingManager,
) : ViewModel() {

    val state = pairingManager.state
        .stateIn(viewModelScope, SharingStarted.Eagerly, PairingState.Idle)

    val isAlreadyPaired: Boolean get() = pairingManager.isPaired

    /** Child submits the 8-char code generated on the parent dashboard. */
    fun submitCode(code: String) = pairingManager.submitCode(code)

    fun cancelPairing() = pairingManager.cancelPairing()

    fun unpair() = pairingManager.unpair()
}
