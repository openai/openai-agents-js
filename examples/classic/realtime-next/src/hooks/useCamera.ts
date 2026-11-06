'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
/**
 * useCamera
 * - Starts/stops a webcam stream on a provided <video> element.
 * - Captures a frame as a JPEG data URL.
 * - Maintains last captured photo and basic state.
 */
export function useCamera() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [isActive, setIsActive] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [lastPhoto, setLastPhoto] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = useCallback(async () => {
    if (isActive) return;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        throw new Error('Video element not ready.');
      }
      video.srcObject = stream;
      // Ensure inline playback on iOS Safari
      (video as any).playsInline = true;
      // Autoplay
      await video.play().catch(async () => {
        // Wait for metadata before play on some browsers
        await new Promise<void>((resolve) => {
          video.onloadedmetadata = () => resolve();
        });
        await video.play();
      });
      setIsActive(true);
    } catch (e) {
      console.error('Failed to start camera', e);
      setError(e instanceof Error ? e.message : 'Failed to start camera');
      stop();
    }
  }, [isActive]);
  const stop = useCallback(() => {
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
    }
    streamRef.current = null;
    const video = videoRef.current;
    if (video) {
      video.srcObject = null;
    }
    setIsActive(false);
  }, []);
  const capture = useCallback(async () => {
    if (!videoRef.current) throw new Error('Video element not ready');
    if (!isActive) throw new Error('Camera not active');
    setIsCapturing(true);
    try {
      const video = videoRef.current;
      const targetWidth = 800;
      const vw = video.videoWidth || targetWidth;
      const vh = video.videoHeight || targetWidth;
      const scale = targetWidth / vw;
      const width = targetWidth;
      const height = Math.max(1, Math.round(vh * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D context not available');
      ctx.drawImage(video, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      setLastPhoto(dataUrl);
      return dataUrl;
    } finally {
      setIsCapturing(false);
    }
  }, [isActive]);
  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);
  return {
    videoRef,
    isActive,
    isCapturing,
    lastPhoto,
    error,
    start,
    stop,
    capture,
    setLastPhoto,
  };
}
export type UseCameraReturn = ReturnType<typeof useCamera>;
