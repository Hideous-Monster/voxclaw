package monster.hideous.voxclaw.ui.conversation.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import monster.hideous.voxclaw.data.model.Message
import monster.hideous.voxclaw.ui.theme.AssistantBubble
import monster.hideous.voxclaw.ui.theme.UserBubble

/**
 * 💬 Message bubble — each one a note in the conversation melody.
 * User messages float right, assistant messages anchor left.
 */
@Composable
fun MessageBubble(message: Message, modifier: Modifier = Modifier) {
    val isUser = message.role == Message.Role.USER
    val bubbleColor = if (isUser) UserBubble else AssistantBubble
    val alignment = if (isUser) Arrangement.End else Arrangement.Start
    val shape = if (isUser) {
        RoundedCornerShape(16.dp, 16.dp, 4.dp, 16.dp)
    } else {
        RoundedCornerShape(16.dp, 16.dp, 16.dp, 4.dp)
    }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp),
        horizontalArrangement = alignment,
    ) {
        Surface(
            color = bubbleColor,
            shape = shape,
            modifier = Modifier.widthIn(max = 300.dp),
        ) {
            Text(
                text = message.content,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.padding(12.dp),
            )
        }
    }
}
