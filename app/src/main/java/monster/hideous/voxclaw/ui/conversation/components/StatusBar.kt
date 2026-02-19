package monster.hideous.voxclaw.ui.conversation.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import monster.hideous.voxclaw.data.model.ConnectionState
import monster.hideous.voxclaw.ui.theme.ErrorRed
import monster.hideous.voxclaw.ui.theme.IdleGray
import monster.hideous.voxclaw.ui.theme.ListeningGreen
import monster.hideous.voxclaw.ui.theme.ProcessingAmber

/**
 * 📡 Status bar — a tiny readout of connection state.
 * Like the tuner on your pedalboard: quick glance, all the info you need.
 */
@Composable
fun StatusBar(connectionState: ConnectionState, modifier: Modifier = Modifier) {
    val (label, color) = when (connectionState) {
        ConnectionState.DISCONNECTED -> "Disconnected" to IdleGray
        ConnectionState.CONNECTING   -> "Connecting..." to ProcessingAmber
        ConnectionState.CONNECTED    -> "Connected"     to ListeningGreen
        ConnectionState.ERROR        -> "Error"         to ErrorRed
    }

    val animatedColor by animateColorAsState(targetValue = color, label = "statusColor")

    Text(
        text = label,
        style = MaterialTheme.typography.labelSmall,
        color = animatedColor,
        modifier = modifier.padding(top = 8.dp, bottom = 16.dp),
    )
}
