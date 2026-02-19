package monster.hideous.voxclaw.ui.conversation

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import monster.hideous.voxclaw.data.model.ConnectionState
import monster.hideous.voxclaw.data.model.ConversationPhase
import monster.hideous.voxclaw.data.model.Message
import monster.hideous.voxclaw.data.network.OpenClawWebSocketClient
import monster.hideous.voxclaw.di.AppModule

/**
 * 🧠 The brains of the operation — like the bassist who also writes all the songs.
 * Manages conversation state, messages, and session lifecycle.
 *
 * Phase 2: Add @HiltViewModel + @Inject constructor and delete the inner Factory class.
 */
class ConversationViewModel(
    private val webSocketClient: OpenClawWebSocketClient,
) : ViewModel() {

    private val _messages = MutableStateFlow<List<Message>>(emptyList())
    val messages: StateFlow<List<Message>> = _messages.asStateFlow()

    private val _connectionState = MutableStateFlow(ConnectionState.DISCONNECTED)
    val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    private val _conversationPhase = MutableStateFlow(ConversationPhase.IDLE)
    val conversationPhase: StateFlow<ConversationPhase> = _conversationPhase.asStateFlow()

    private val _sessionActive = MutableStateFlow(false)
    val sessionActive: StateFlow<Boolean> = _sessionActive.asStateFlow()

    /** 🎚️ Toggle the session — flip the switch, let's go! */
    fun toggleSession() {
        if (_sessionActive.value) stopSession() else startSession()
    }

    private fun startSession() {
        _sessionActive.value = true
        _connectionState.value = ConnectionState.CONNECTING
        // Fake a connection delay — the anticipation before the drop 🥁
        viewModelScope.launch {
            delay(500)
            _connectionState.value = ConnectionState.CONNECTED
            _conversationPhase.value = ConversationPhase.LISTENING
        }
    }

    private fun stopSession() {
        _sessionActive.value = false
        _connectionState.value = ConnectionState.DISCONNECTED
        _conversationPhase.value = ConversationPhase.IDLE
    }

    /**
     * 📝 Send a message — for testing until STT takes over in Phase 2.
     * Adds the user message then fakes an assistant response after a beat.
     */
    fun sendMessage(text: String) {
        if (text.isBlank()) return
        _messages.update { it + Message(role = Message.Role.USER, content = text) }

        // Echo back like a bass player riffing off the rhythm 🎸
        viewModelScope.launch {
            _conversationPhase.value = ConversationPhase.PROCESSING
            delay(1000)
            _messages.update {
                it + Message(
                    role = Message.Role.ASSISTANT,
                    content = "I heard you say: \"$text\" — but I'm just a stub for now! 🎤",
                )
            }
            _conversationPhase.value = ConversationPhase.LISTENING
        }
    }

    // -------------------------------------------------------------------------
    // Manual DI factory — Phase 2: delete this and add @HiltViewModel above
    // -------------------------------------------------------------------------
    class Factory(context: Context) : ViewModelProvider.Factory {
        private val appContext = context.applicationContext
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T =
            ConversationViewModel(AppModule.provideWebSocketClient()) as T
    }
}
