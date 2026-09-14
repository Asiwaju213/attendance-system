export interface ImportedStudentRow {
  rowNumber: number;
  studentName: string;
  matricNumber: string;
  valid: boolean;
  errors: string[];
}

export interface StudentImportPreviewData {
  department: { id: number; name: string };
  level: { id: number; name: number };
  totalRows: number;
  validRows: number;
  invalidRows: number;
  rows: ImportedStudentRow[];
  previewToken: string;
}

export interface StudentImportResultData {
  importedCount: number;
}