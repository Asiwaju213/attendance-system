declare module "exceljs" {
  type CellValue =
    | string
    | number
    | boolean
    | Date
    | null
    | undefined;

  interface Font {
    bold?: boolean;
    size?: number;
    name?: string;
  }

  interface RgbColor {
    argb: string;
  }

  interface PatternFill {
    type: "pattern";
    pattern: "solid";
    fgColor: RgbColor;
  }

  interface BorderStyle {
    style: string;
    color: RgbColor;
  }

  interface Border {
    top?: BorderStyle;
    left?: BorderStyle;
    bottom?: BorderStyle;
    right?: BorderStyle;
  }

  export class Cell {
    value: CellValue;
    font?: Font;
    fill?: PatternFill;
    border?: Border;
    numFmt?: string;
  }

  export class Row {
    getCell(column: number): Cell;
  }

  interface ColumnWidths {
    width?: number;
  }

  interface WorksheetView {
    state: "frozen";
    xSplit?: number;
    ySplit?: number;
  }

  export class Worksheet {
    name: string;
    columns: ColumnWidths[];
    views: WorksheetView[];
    getCell(row: number, column: number): Cell;
    getRow(row: number): Row;
  }

  export class Xlsx {
    writeBuffer(): Promise<ArrayBuffer | Uint8Array>;
  }

  export class Workbook {
    constructor();
    creator?: string;
    created?: Date;
    worksheets: Worksheet[];
    addWorksheet(name: string): Worksheet;
    xlsx: Xlsx;
  }

  const ExcelJS: {
    Workbook: typeof Workbook;
    Worksheet: typeof Worksheet;
    Row: typeof Row;
    Cell: typeof Cell;
  };

  export default ExcelJS;
}