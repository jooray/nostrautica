package today.cypherpunk.nostrautica.ui.components

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.foundation.layout.Box
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

/**
 * One pixel array and one copy into the bitmap: a setPixel per pixel was 262,144
 * calls into the native bitmap for a 512 px code. Still CPU work, so callers on
 * the main thread go through [QrCode], which builds it on Dispatchers.Default.
 */
fun qrBitmap(text: String, px: Int = 512): Bitmap {
    val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, px, px, mapOf(EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M, EncodeHintType.MARGIN to 1))
    val w = m.width
    val h = m.height
    val pixels = IntArray(w * h)
    for (y in 0 until h) {
        val row = y * w
        for (x in 0 until w) pixels[row + x] = if (m[x, y]) android.graphics.Color.BLACK else android.graphics.Color.WHITE
    }
    return Bitmap.createBitmap(pixels, w, h, Bitmap.Config.ARGB_8888)
}

/** A QR code on a white tile (scanners need the contrast in dark mode too). */
@Composable
fun QrCode(text: String, size: Dp = 240.dp, modifier: Modifier = Modifier) {
    // Encoded off the main thread: Admin lists a code per invite, and building them all
    // during composition held the UI thread for each one in turn.
    val bmp by produceState<Bitmap?>(null, text) { value = withContext(Dispatchers.Default) { qrBitmap(text) } }
    val tile = modifier.clip(RoundedCornerShape(12.dp)).background(Color.White).padding(10.dp).size(size)
    val b = bmp
    if (b == null) Box(tile)
    else Image(b.asImageBitmap(), contentDescription = null, filterQuality = FilterQuality.None, modifier = tile)
}
