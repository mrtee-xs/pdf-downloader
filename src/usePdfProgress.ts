import { useEffect, useState } from 'react';

// Generate a unique session ID per browser tab
const SESSION_ID = Math.random().toString(36).substring(2, 12);

export interface ProgressData {
  status?: 'idle' | 'uploading' | 'success' | 'failed' | 'downloading-local' | 'saved-local';
  progress?: number;
  transferredMB?: string;
  link?: string;
  error?: string;
}

export function usePdfProgress(baseUrl: string = '') {
  // Map of pdf.url -> { status, progress (0-100), transferredMB, link, error }
  const [progressMap, setProgressMap] = useState<Record<string, ProgressData>>({});

  // 1. Listen to Backend SSE for Google Drive Upload Progress
  useEffect(() => {
    const eventSource = new EventSource(
      `${baseUrl}/api/progress-stream?sessionId=${SESSION_ID}`
    );

    eventSource.onmessage = event => {
      try {
        const data = JSON.parse(event.data);
        if (!data || !data.url) return;
        setProgressMap(prev => ({
          ...prev,
          [data.url]: { ...prev[data.url], ...data },
        }));
      } catch (_) {}
    };

    return () => eventSource.close();
  }, [baseUrl]);

  // 2. Local File Download with Real-Time Percentage Tracking
  const downloadLocalWithProgress = async (pdf: {
    url: string;
    filename: string;
    sizeBytes?: number;
  }) => {
    setProgressMap(prev => ({
      ...prev,
      [pdf.url]: { status: 'downloading-local', progress: 0 },
    }));

    try {
      const res = await fetch(
        `${baseUrl}/api/download-local?url=${encodeURIComponent(
          pdf.url
        )}&filename=${encodeURIComponent(pdf.filename)}`
      );
      if (!res.ok || !res.body) throw new Error('Download stream failed');

      const totalBytes =
        parseInt(res.headers.get('Content-Length') || '0', 10) || pdf.sizeBytes || 0;
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let receivedBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          receivedBytes += value.length;
          if (totalBytes > 0) {
            const percent = Math.min(100, Math.round((receivedBytes / totalBytes) * 100));
            setProgressMap(prev => ({
              ...prev,
              [pdf.url]: {
                status: 'downloading-local',
                progress: percent,
                transferredMB: (receivedBytes / (1024 * 1024)).toFixed(2),
              },
            }));
          } else {
            setProgressMap(prev => ({
              ...prev,
              [pdf.url]: {
                status: 'downloading-local',
                progress: undefined,
                transferredMB: (receivedBytes / (1024 * 1024)).toFixed(2),
              },
            }));
          }
        }
      }

      // Assemble chunks into a PDF Blob and trigger browser save
      const blob = new Blob(chunks, { type: 'application/pdf' });
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = pdf.filename;
      document.body.appendChild(a);
      a.click();
      URL.revokeObjectURL(blobUrl);
      a.remove();

      setProgressMap(prev => ({
        ...prev,
        [pdf.url]: { status: 'saved-local', progress: 100 },
      }));
    } catch (err: any) {
      setProgressMap(prev => ({
        ...prev,
        [pdf.url]: { status: 'failed', progress: 0, error: err.message },
      }));
    }
  };

  return { progressMap, downloadLocalWithProgress, sessionId: SESSION_ID };
}
