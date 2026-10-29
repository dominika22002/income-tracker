declare module 'pdfmake/build/pdfmake.js' {
  import type { TCreatedPdf, TDocumentDefinitions } from 'pdfmake/interfaces';

  const pdfMake: {
    addVirtualFileSystem(virtualFileSystem: Record<string, string>): void;
    createPdf(definition: TDocumentDefinitions): TCreatedPdf;
  };
  export default pdfMake;
}

declare module 'pdfmake/build/vfs_fonts.js' {
  const virtualFileSystem: Record<string, string>;
  export default virtualFileSystem;
}
