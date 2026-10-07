// Adds the original capture date to a JPEG, so a saved photo lands on the right
// day in the iPhone Photos app instead of on the day you saved it.
export async function withCaptureDate(blob, time) {
  const jpeg = new Uint8Array(await blob.arrayBuffer());
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return blob;

  const d = new Date(time);
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}\0`;

  // A tiny EXIF block: DateTime in the main section, plus DateTimeOriginal and
  // DateTimeDigitized in the camera section. All three point at one date string.
  const IFD0 = 8, EXIF = IFD0 + 2 + 2 * 12 + 4, DATA = EXIF + 2 + 2 * 12 + 4;
  const tiff = new DataView(new ArrayBuffer(DATA + 20));
  const entry = (at, tag, type, count, value) => {
    tiff.setUint16(at, tag);
    tiff.setUint16(at + 2, type);
    tiff.setUint32(at + 4, count);
    tiff.setUint32(at + 8, value);
  };
  tiff.setUint16(0, 0x4d4d); // big-endian "MM"
  tiff.setUint16(2, 42);
  tiff.setUint32(4, IFD0);
  tiff.setUint16(IFD0, 2);
  entry(IFD0 + 2, 0x0132, 2, 20, DATA); // DateTime
  entry(IFD0 + 14, 0x8769, 4, 1, EXIF); // pointer to camera section
  tiff.setUint32(IFD0 + 26, 0);
  tiff.setUint16(EXIF, 2);
  entry(EXIF + 2, 0x9003, 2, 20, DATA); // DateTimeOriginal
  entry(EXIF + 14, 0x9004, 2, 20, DATA); // DateTimeDigitized
  tiff.setUint32(EXIF + 26, 0);
  for (let i = 0; i < 20; i++) tiff.setUint8(DATA + i, stamp.charCodeAt(i));

  const body = new Uint8Array(tiff.buffer);
  const len = 2 + 6 + body.length;
  const app1 = new Uint8Array(2 + len);
  app1.set([0xff, 0xe1, len >> 8, len & 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0]); // "Exif\0\0"
  app1.set(body, 10);

  // Insert after the JFIF header if there is one, otherwise right after the start marker.
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + ((jpeg[4] << 8) | jpeg[5]);
  return new Blob([jpeg.subarray(0, at), app1, jpeg.subarray(at)], { type: "image/jpeg" });
}
