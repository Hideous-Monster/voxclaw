package monster.hideous.voxclaw.data.model

/**
 * 🔌 Connection state — are we plugged in or not?
 */
enum class ConnectionState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    ERROR,
}

/**
 * 🎙️ What's happening in the conversation right now.
 * Like the stages of a killer bass solo:
 * IDLE → warming up, LISTENING → feeling the groove,
 * PROCESSING → cooking up something nasty, SPEAKING → dropping the riff.
 */
enum class ConversationPhase {
    IDLE,
    LISTENING,
    PROCESSING,
    SPEAKING,
}
