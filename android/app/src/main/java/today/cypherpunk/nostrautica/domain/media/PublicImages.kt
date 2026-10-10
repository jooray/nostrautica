package today.cypherpunk.nostrautica.domain.media

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.net.Uri
import androidx.exifinterface.media.ExifInterface
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import today.cypherpunk.nostrautica.nostr.Relays
import today.cypherpunk.nostrautica.protocol.NostrSigner
import java.io.ByteArrayOutputStream

/**
 * Public (unencrypted) images on Blossom (media/image.ts): avatars and event art.
 * Re-encoding through a Bitmap strips EXIF (GPS included) by construction and
 * bounds the size; it fails closed — an unreadable image is an error, never a
 * silent upload of the raw original.
 */
object PublicImages {
    const val AVATAR_SIZE = 512

    /** Square-crop a photo to a 512 px JPEG with no metadata (audit APPR-3). */
    suspend fun prepareAvatar(context: Context, uri: Uri): ByteArray = coverCrop(context, uri, AVATAR_SIZE, AVATAR_SIZE, png = false)

    /** Center-crop ("cover") to an exact size; JPEG unless [png]. */
    suspend fun coverCrop(context: Context, uri: Uri, targetW: Int, targetH: Int, png: Boolean = false): ByteArray = withContext(Dispatchers.Default) {
        val cr = context.contentResolver
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        cr.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw UserFacingError("join.android.photoUnreadable")
        // Decode no larger than needed (a 48 MP original would otherwise cost ~200 MB).
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= targetW && bounds.outHeight / (sample * 2) >= targetH) sample *= 2
        val decoded = cr.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) }
            ?: throw UserFacingError("join.android.photoUnreadable")
        val upright = runCatching {
            val orientation = cr.openInputStream(uri)?.use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }
                ?: ExifInterface.ORIENTATION_NORMAL
            val m = Matrix()
            when (orientation) {
                ExifInterface.ORIENTATION_ROTATE_90 -> m.postRotate(90f)
                ExifInterface.ORIENTATION_ROTATE_180 -> m.postRotate(180f)
                ExifInterface.ORIENTATION_ROTATE_270 -> m.postRotate(270f)
                ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.postScale(-1f, 1f)
                ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.postScale(1f, -1f)
            }
            if (m.isIdentity) decoded else Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, m, true)
        }.getOrDefault(decoded)
        try {
            val scale = maxOf(targetW.toFloat() / upright.width, targetH.toFloat() / upright.height)
            val sw = targetW / scale
            val sh = targetH / scale
            val sx = (upright.width - sw) / 2
            val sy = (upright.height - sh) / 2
            val out = Bitmap.createBitmap(targetW, targetH, Bitmap.Config.ARGB_8888)
            Canvas(out).drawBitmap(upright, Rect(sx.toInt(), sy.toInt(), (sx + sw).toInt(), (sy + sh).toInt()), RectF(0f, 0f, targetW.toFloat(), targetH.toFloat()), Paint(Paint.FILTER_BITMAP_FLAG))
            val bytes = ByteArrayOutputStream().also { out.compress(if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, 90, it) }.toByteArray()
            out.recycle()
            bytes
        } catch (e: Exception) {
            throw UserFacingError("join.android.photoUnreadable")
        } finally {
            if (upright !== decoded) upright.recycle()
            decoded.recycle()
        }
    }

    /**
     * Upload a public image; returns its primary URL. Unlike encrypted media this
     * honors the user's own 10063 servers (ordinary images are what they're for).
     */
    suspend fun upload(media: IntroMedia, signer: NostrSigner, bytes: ByteArray, mime: String, eventBlossom: List<String> = emptyList()): String {
        val user = runCatching { media.userBlossomServers(signer.pubkey) }.getOrDefault(emptyList())
        val servers = BlossomClient.union(eventBlossom, user, Relays.BLOSSOM).filter(BlossomClient::isAcceptedBlossomUrl)
        return media.blossom.uploadAndMirror(signer, servers, bytes, mime).primary
    }
}
