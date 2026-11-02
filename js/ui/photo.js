const MAX_SIDE = 1600;
const JPEG_QUALITY = 0.7;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve({ image, url });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Не удалось прочитать фото'));
    };
    image.src = url;
  });
}

// Downscales to 1600 px on the long side and re-encodes as JPEG 0.7. Going through
// <img> applies the EXIF orientation of phone photos.
export async function compressPhoto(file) {
  const { image, url } = await loadImage(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(url);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Не удалось сжать фото'))), 'image/jpeg', JPEG_QUALITY);
  });
}
