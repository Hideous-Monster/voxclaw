package monster.hideous.voxclaw.ui.conversation

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import monster.hideous.voxclaw.service.VoxClawService
import monster.hideous.voxclaw.ui.conversation.components.MessageBubble
import monster.hideous.voxclaw.ui.conversation.components.SessionToggleButton
import monster.hideous.voxclaw.ui.conversation.components.StatusBar

/**
 * 🎶 The main stage — where the conversation unfolds.
 * Receives its ViewModel from MainActivity (Phase 2: use hiltViewModel() directly).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationScreen(viewModel: ConversationViewModel) {
    val messages by viewModel.messages.collectAsStateWithLifecycle()
    val connectionState by viewModel.connectionState.collectAsStateWithLifecycle()
    val phase by viewModel.conversationPhase.collectAsStateWithLifecycle()
    val sessionActive by viewModel.sessionActive.collectAsStateWithLifecycle()

    val context = LocalContext.current
    val listState = rememberLazyListState()
    var testInput by remember { mutableStateOf("") }

    // 🔐 Permission request launcher — politely ask before we start recording
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { grants ->
        if (grants.values.all { it }) {
            viewModel.toggleSession()
            VoxClawService.start(context)
        }
    }

    // Auto-scroll to latest message — keep up with the conversation!
    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) {
            listState.animateScrollToItem(messages.size - 1)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("VoxClaw", style = MaterialTheme.typography.titleLarge) },
                actions = {
                    IconButton(onClick = { /* TODO: Settings screen Phase 2 🎛️ */ }) {
                        Icon(Icons.Default.Settings, contentDescription = "Settings")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding(),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            // 💬 Scrollable conversation log
            LazyColumn(
                state = listState,
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                verticalArrangement = Arrangement.Bottom,
            ) {
                items(messages, key = { it.timestamp }) { msg ->
                    MessageBubble(message = msg)
                }
            }

            // ⌨️ Temporary test input — will be replaced by STT in Phase 2
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = testInput,
                    onValueChange = { testInput = it },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("Type to test messages...") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = {
                        viewModel.sendMessage(testInput)
                        testInput = ""
                    }),
                )
                IconButton(onClick = {
                    viewModel.sendMessage(testInput)
                    testInput = ""
                }) {
                    Icon(Icons.Default.Send, contentDescription = "Send")
                }
            }

            Spacer(modifier = Modifier.height(16.dp))

            // 🔴 The big toggle — start/stop the session
            SessionToggleButton(
                isActive = sessionActive,
                phase = phase,
                onClick = {
                    if (sessionActive) {
                        viewModel.toggleSession()
                        VoxClawService.stop(context)
                    } else {
                        val permissions = buildList {
                            add(Manifest.permission.RECORD_AUDIO)
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                                add(Manifest.permission.BLUETOOTH_CONNECT)
                            }
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                                add(Manifest.permission.POST_NOTIFICATIONS)
                            }
                        }
                        if (permissions.all {
                                ContextCompat.checkSelfPermission(context, it) ==
                                    PackageManager.PERMISSION_GRANTED
                            }) {
                            viewModel.toggleSession()
                            VoxClawService.start(context)
                        } else {
                            permissionLauncher.launch(permissions.toTypedArray())
                        }
                    }
                },
            )

            // 📡 Connection status indicator
            StatusBar(connectionState = connectionState)
        }
    }
}
