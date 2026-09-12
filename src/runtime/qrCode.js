import qrcodeGenerator from './vendor/qrcode.cjs';

/*
 Thin wrapper over the vendored MIT qrcode-generator (Kazuhiko Arase, 2009 —
 see vendor/qrcode.cjs header). The login page renders the enrollment QR as a
 responsive SVG; the otpauth:// URI is ASCII-only, so the generator's default
 latin-1 byte conversion is sufficient.
 */

export function qrSvg(content, { cellSize = 4, margin = 8 } = {}) {
  const qr = qrcodeGenerator(0, 'M');
  qr.addData(String(content), 'Byte');
  qr.make();
  return qr.createSvgTag({ cellSize, margin, scalable: true, alt: { text: 'QR code' } });
}
