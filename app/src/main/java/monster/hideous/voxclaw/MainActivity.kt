package monster.hideous.voxclaw

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import monster.hideous.voxclaw.ui.conversation.ConversationScreen
import monster.hideous.voxclaw.ui.conversation.ConversationViewModel
import monster.hideous.voxclaw.ui.theme.VoxClawTheme

/**
 * 🎤 Main stage — one activity to rule them all.
 *
 * Phase 2: Add @AndroidEntryPoint here (after @HiltAndroidApp is on VoxClawApp).
 * The ViewModel factory becomes unnecessary — hiltViewModel() takes over in the screen.
 */
class MainActivity : ComponentActivity() {

    // Manual ViewModel wiring — swapped for hiltViewModel() in Phase 2
    private val conversationViewModel: ConversationViewModel by viewModels {
        ConversationViewModel.Factory(this)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            VoxClawTheme {
                ConversationScreen(viewModel = conversationViewModel)
            }
        }
    }
}
