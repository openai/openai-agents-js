'use client';
import { useCamera } from '@/hooks/useCamera';
import { Button } from '@/components/ui/Button';
import { useCallback, useEffect, useRef } from 'react';
type CameraCaptureProps = {
  onCapture: (dataUrl: string) => void | Promise<void>;
  disabled?: boolean;
  className?: string;
  continuous?: boolean;
  fps?: number; // frames per second for continuous mode (default 1)
};
/**
 * CameraCapture
 * - Start/stop camera and show a live preview.
 * - Capture sends the current frame via onCapture, but does not auto-stop the camera.
 * - Shows the last captured photo preview.
 */
export function CameraCapture({
  onCapture,
  disabled = false,
  className = '',
  continuous = false,
  fps = 1,
}: CameraCaptureProps) {
  const {
    videoRef,
    isActive,
    isCapturing,
    lastPhoto,
    error,
    start,
    stop,
    capture,
  } = useCamera();
  const capturingRef = useRef(isCapturing);
  const intervalRef = useRef<number | null>(null);
  useEffect(() => {
    capturingRef.current = isCapturing;
  }, [isCapturing]);
  const handleCapture = useCallback(async () => {
    try {
      const dataUrl = await capture();
      await onCapture(dataUrl);
    } catch (e) {
      console.error('Capture failed', e);
    }
  }, [capture, onCapture]);
  // Continuous capture loop (when enabled and camera active)
  useEffect(() => {
    // Clear any existing interval if conditions not met
    const clear = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
    if (!continuous || !isActive || disabled) {
      clear();
      return;
    }
    // Clamp FPS to a sensible range
    const clampedFps = Math.max(0.2, Math.min(30, Number(fps) || 1));
    const intervalMs = Math.round(1000 / clampedFps);
    intervalRef.current = window.setInterval(async () => {
      if (capturingRef.current) return;
      try {
        const dataUrl = await capture();
        await onCapture(dataUrl);
      } catch (e) {
        console.error('Continuous capture failed', e);
      }
    }, intervalMs);
    return clear;
  }, [continuous, isActive, disabled, fps, capture, onCapture]);
  return (
    <div
      className={
        'flex flex-col items-end gap-2 p-2 rounded-md ' + (className ?? '')
      }
    >
      {/* Always render the video so the ref is ready when start() is called */}
      <video
        ref={videoRef}
        className={
          'w-56 h-auto rounded-md border border-gray-300 shadow bg-black ' +
          (isActive ? 'block' : 'hidden')
        }
        muted
        autoPlay
      />
      {error && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
          {error}
        </div>
      )}
      {isActive ? (
        <div className="flex gap-2">
          <Button
            onClick={handleCapture}
            variant="primary"
            disabled={disabled || isCapturing}
          >
            {isCapturing ? 'Capturing…' : 'Capture'}
          </Button>
          <Button onClick={stop} variant="outline">
            Stop Camera
          </Button>
        </div>
      ) : (
        <Button onClick={start} variant="primary" disabled={disabled}>
          Start Camera
        </Button>
      )}
      {lastPhoto && (
        <img
          src={lastPhoto}
          alt="Last captured photo"
          className="w-40 h-auto rounded-md border border-gray-300 shadow-md bg-white"
        />
      )}
    </div>
  );
}
