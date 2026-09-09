package org.setbd.parentcontrol.emergency

import org.setbd.parentcontrol.di.ServiceLocator

/**
 * Emergency contacts configured by the parent in the policy document
 * (`devices/{deviceId}/policies/current` → `emergencyContacts`:
 * `[{name, phone, relation}]`).
 *
 * The child dashboard lists them so the child can dial via the standard
 * ACTION_DIAL intent (no CALL_PHONE permission needed — the user confirms in
 * the dialer). We never auto-dial and never read the device's contact list.
 */
object EmergencyContacts {

    data class Contact(val name: String, val phone: String, val relation: String?)

    /**
     * Returns the current contacts. Reads the cached policy so it works fully
     * offline (the policy repository keeps the last valid policy encrypted
     * on-device).
     */
    fun current(): List<Contact> {
        val policy = ServiceLocator.policyRepository.currentPolicy() ?: return emptyList()
        return policy.emergencyContacts.mapNotNull { c ->
            val name = c["name"] ?: return@mapNotNull null
            val phone = c["phone"] ?: return@mapNotNull null
            Contact(name = name, phone = phone, relation = c["relation"])
        }
    }
}
