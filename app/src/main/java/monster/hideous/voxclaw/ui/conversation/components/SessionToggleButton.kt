package monster.hideous.voxclaw.ui.conversation.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.unit.dp
import monster.hideous.voxclaw.data.model.ConversationPhase
import monster.hideous.voxclaw.ui.theme.IdleGray
import monster.hideous.voxclaw.ui.theme.ListeningGreen
import monster.hideous.voxclaw.ui.theme.ProcessingAmber
import monster.hideous.voxclaw.ui.theme.SpeakingBlue

/**
 * 🔵 The big toggle button — mood ring for your voice session.
 * Color reflects state: gray = idle, green = listening, amber = thinking, blue = talking.
 */
@Composable
fun SessionToggleButton(
    isActive: Boolean,
    phase: ConversationPhase,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val targetColor = when {
        !isActive -> IdleGray
        phase == ConversationPhase.LISTENING -> ListeningGreen
        phase == ConversationPhase.PROCESSING -> ProcessingAmber
        phase == ConversationPhase.SPEAKING -> SpeakingBlue
        else -> IdleGray
    }

    val buttonColor by animateColorAsState(
        targetValue = targetColor,
        animationSpec = tween(durationMillis = 300),
        label = "buttonColor",
    )

    // Subtle breathing pulse when listening 🫁
    val scale by animateFloatAsState(
        targetValue = if (isActive && phase == ConversationPhase.LISTENING) 1.08f else 1f,
        animationSpec = tween(durationMillis = 600),
        label = "buttonScale",
    )

    Box(contentAlignment = Alignment.Center, modifier = modifier) {
        FloatingActionButton(
            onClick = onClick,
            shape = CircleShape,
            containerColor = buttonColor,
            modifier = Modifier
                .size(80.dp)
                .scale(scale),
        ) {
            Icon(
                imageVector = if (isActive) Icons.Default.Mic else Icons.Default.MicOff,
                contentDescription = if (isActive) "End Session" else "Start Session",
                modifier = Modifier.size(36.dp),
                tint = MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}
