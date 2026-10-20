package today.cypherpunk.nostrautica.ui.components

import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.GraphicsMode

/** The bulk-pixel [qrBitmap] draws exactly the modules zxing encoded. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class QrBitmapTest {
    @Test fun everyPixelMatchesTheEncodedMatrix() {
        val text = "nostrconnect://" + "ab".repeat(32) + "?relay=wss%3A%2F%2Frelay.example&secret=0123456789abcdef"
        val px = 128
        val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, px, px, mapOf(EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M, EncodeHintType.MARGIN to 1))
        val bmp = qrBitmap(text, px)
        assertEquals(m.width, bmp.width)
        assertEquals(m.height, bmp.height)
        for (y in 0 until m.height) for (x in 0 until m.width) {
            assertEquals("($x,$y)", if (m[x, y]) android.graphics.Color.BLACK else android.graphics.Color.WHITE, bmp.getPixel(x, y))
        }
    }
}
