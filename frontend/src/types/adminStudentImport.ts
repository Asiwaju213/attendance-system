export interface StudentImportPreviewRow {
  rowNumber: number;
  studentName: string;
  matricNumber: string;
  valid: boolean;
  errors: string[];
}

export interface StudentImportPreview {
  department: { id: number; name: string };
  level: { id: number; name: number };
  totalRows: number;
  validRows: number;
  invalidRows: number;
  rows: StudentImportPreviewRow[];
  previewToken: string;
}

export interface StudentImportResult {
  importedCount: number;
}