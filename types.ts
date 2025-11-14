
export interface Source {
  uri: string;
  title: string;
}

export interface AnalyzedReportData {
  title: string;
  reporter: string;
  summary: string;
  sources: Source[];
}

export type RecordingState = 'audio' | 'video' | null;
