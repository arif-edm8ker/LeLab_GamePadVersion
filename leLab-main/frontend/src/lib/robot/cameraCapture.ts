// Camera frames for a policy: grab the current webcam image at the size the
// policy was trained on and JPEG-encode it for the server.

export interface CameraCapture {
  /** The current frame, scaled to the policy's size, as JPEG bytes. */
  grab(): Promise<Uint8Array>;
  close(): void;
}

// High enough that compression adds little beyond what training videos had.
const JPEG_QUALITY = 0.92;

export async function openBrowserCamera(deviceId: string, width: number, height: number): Promise<CameraCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: deviceId }, width: { ideal: width }, height: { ideal: height } },
  });
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await video.play();
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    throw e;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser can't draw camera frames.");

  return {
    async grab() {
      context.drawImage(video, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
      if (!blob) throw new Error("Couldn't encode a camera frame.");
      return new Uint8Array(await blob.arrayBuffer());
    },
    close() {
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}
