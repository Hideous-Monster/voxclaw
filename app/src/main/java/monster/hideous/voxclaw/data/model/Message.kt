package monster.hideous.voxclaw.data.model

import kotlinx.serialization.Serializable

/**
 * 💬 A single message in the conversation — like notes in a song.
 * Each one has a role (who's singing) and content (the lyrics).
 */
@Serializable
data class Message(
    val role: Role,
    val content: String,
    val timestamp: Long = System.currentTimeMillis(),
) {
    enum class Role { USER, ASSISTANT }
}
