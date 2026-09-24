export type DocumentSource = 'resume' | 'jd' | 'kb' | 'sql';

export interface SourceDocumentInput {
  text: string;
  source: DocumentSource;
  fileName: string;
}
