
import React, { useState, useCallback, useRef } from 'react';
// FIX: Removed non-exported type 'LiveSession'.
import { GoogleGenAI, LiveServerMessage, Modality, Blob } from "@google/genai";
import { Header } from './components/Header';
import { CaseReportForm } from './components/CaseReportForm';
import { AnalyzedReport } from './components/AnalyzedReport';
import { Spinner } from './components/Spinner';
import { analyzeCaseReport } from './services/geminiService';
import { sendToTelegram } from './services/telegramService';
import type { AnalyzedReportData, RecordingState } from './types';
import { encode } from './utils/audio';

if (!process.env.API_KEY) {
  throw new Error("API_KEY environment variable is not set");
}
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export default function App() {
  const [reportText, setReportText] = useState<string>('');
  const [title, setTitle] = useState('');
  const [reporter, setReporter] = useState('');
  const [analyzedReport, setAnalyzedReport] = useState<AnalyzedReportData | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [loadingMessage, setLoadingMessage] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [telegramSuccess, setTelegramSuccess] = useState<string | null>(null);
  const [recordingState, setRecordingState] = useState<RecordingState>(null);

  // FIX: Replaced 'LiveSession' with 'any' as it is not an exported type.
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const mediaStreamSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);


  const stopRecording = useCallback(async () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      await audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }
    if(mediaStreamSourceRef.current) {
      mediaStreamSourceRef.current.disconnect();
      mediaStreamSourceRef.current = null;
    }
    if (sessionPromiseRef.current) {
        const session = await sessionPromiseRef.current;
        session.close();
        sessionPromiseRef.current = null;
    }
    setRecordingState(null);
  }, []);

  const handleToggleRecording = useCallback(async (type: 'audio' | 'video') => {
    if (recordingState) {
      await stopRecording();
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: type === 'video',
      });
      streamRef.current = stream;
      setRecordingState(type);
      setReportText(''); // Clear previous report text

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            // FIX: Cast 'window' to 'any' to support 'webkitAudioContext' for broader browser compatibility without TypeScript errors.
            const context = new ((window as any).AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
            audioContextRef.current = context;
            const source = context.createMediaStreamSource(stream);
            mediaStreamSourceRef.current = source;
            const scriptProcessor = context.createScriptProcessor(4096, 1, 1);
            scriptProcessorRef.current = scriptProcessor;

            scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
              const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
              const l = inputData.length;
              const int16 = new Int16Array(l);
              for (let i = 0; i < l; i++) {
                int16[i] = inputData[i] * 32768;
              }
              const pcmBlob: Blob = {
                data: encode(new Uint8Array(int16.buffer)),
                mimeType: 'audio/pcm;rate=16000',
              };
              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(context.destination);
          },
          onmessage: (message: LiveServerMessage) => {
            const transcript = message.serverContent?.inputTranscription?.text;
            if (transcript) {
              setReportText(prev => (prev ? prev + " " : "") + transcript);
            }
          },
          // FIX: Changed the parameter type from 'Error' to 'ErrorEvent' to match the expected callback signature.
          onerror: (e: ErrorEvent) => {
            console.error('Session error:', e);
            setError('Ralat berlaku dengan sesi rakaman.');
            stopRecording();
          },
          onclose: () => {
             // The stopRecording function is already called on user action or error
          },
        },
        config: {
          inputAudioTranscription: {},
        },
      });
      sessionPromiseRef.current = sessionPromise;

    } catch (err) {
      console.error('Error getting user media:', err);
      setError('Tidak dapat mengakses mikrofon/kamera. Sila semak kebenaran.');
      setRecordingState(null);
    }

  }, [recordingState, stopRecording]);

  const handleAnalyze = useCallback(async () => {
    if (!reportText.trim() || !title.trim() || !reporter.trim()) {
      setError('Tajuk, Nama Pelapor, dan Butiran Laporan tidak boleh kosong.');
      return;
    }
    setIsLoading(true);
    setLoadingMessage('Gemini sedang menganalisis dan menambah maklumat berdasarkan web..');
    setError(null);
    setAnalyzedReport(null);
    setTelegramSuccess(null);

    try {
      const result = await analyzeCaseReport(title, reporter, reportText);
      setAnalyzedReport(result);
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : 'Berlaku ralat tidak diketahui semasa analisis.');
    } finally {
      setIsLoading(false);
      setLoadingMessage('');
    }
  }, [reportText, title, reporter]);

  const handleSend = useCallback(async () => {
    if (!reportText.trim() || !title.trim() || !reporter.trim()) {
        setError('Tajuk, Nama Pelapor, dan Butiran Laporan tidak boleh kosong.');
        return;
    }

    setIsLoading(true);
    setLoadingMessage('Menghantar ke Telegram...');
    setError(null);
    setTelegramSuccess(null);

    try {
        const reportToSend: AnalyzedReportData = analyzedReport 
            ? analyzedReport 
            : {
                title: title,
                reporter: reporter,
                summary: reportText, // Use raw text as summary for non-analyzed reports
                sources: []
            };
        
        const result = await sendToTelegram(reportToSend);
        setTelegramSuccess(`Laporan berjaya dihantar ke Telegram! ID Mesej: ${result.message_id}`);
    } catch (e) {
        console.error(e);
        setError(e instanceof Error ? e.message : 'Berlaku ralat tidak diketahui semasa menghantar ke Telegram.');
    } finally {
        setIsLoading(false);
        setLoadingMessage('');
    }
  }, [analyzedReport, reportText, title, reporter]);

  return (
    <div className="min-h-screen bg-sky-50 font-sans text-slate-800 flex flex-col items-center p-4">
      <div className="w-full max-w-3xl mx-auto">
        <Header />
        <main className="mt-8">
          <CaseReportForm 
            reportText={reportText}
            onReportTextChange={setReportText}
            title={title}
            onTitleChange={setTitle}
            reporter={reporter}
            onReporterChange={setReporter}
            onAnalyze={handleAnalyze} 
            onSend={handleSend}
            isAnalyzing={isLoading && loadingMessage.includes('menganalisis')}
            isSending={isLoading && loadingMessage.includes('Menghantar')}
            recordingState={recordingState}
            onToggleRecording={handleToggleRecording}
            mediaStream={streamRef.current}
          />

          {isLoading && (
            <div className="mt-6 flex flex-col items-center justify-center text-center p-6 bg-white/50 rounded-lg">
              <Spinner />
              <p className="mt-4 text-lg text-teal-600 animate-pulse">{loadingMessage}</p>
            </div>
          )}

          {error && (
            <div className="mt-6 p-4 bg-red-100 border border-red-400 text-red-700 rounded-lg">
              <p className="font-bold">Ralat</p>
              <p>{error}</p>
            </div>
          )}

          {telegramSuccess && (
             <div className="mt-6 p-4 bg-green-100 border border-green-400 text-green-700 rounded-lg">
              <p className="font-bold">Berjaya</p>
              <p>{telegramSuccess}</p>
            </div>
          )}

          {analyzedReport && !isLoading && (
            <AnalyzedReport data={analyzedReport} />
          )}
        </main>
      </div>
    </div>
  );
}
