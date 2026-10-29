import pdfMake from 'pdfmake/build/pdfmake.js';
import virtualFileSystem from 'pdfmake/build/vfs_fonts.js';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import type { SaveReportPdfRequest } from '../shared/contracts';

pdfMake.addVirtualFileSystem(virtualFileSystem);

function chartBars(values: readonly string[], maximumWidth = 280) {
  const amounts = values.map(Number);
  const maximum = Math.max(0, ...amounts);
  return values.map((value, index) => ({
    type: 'rect' as const,
    x: 0,
    y: index * 24,
    w: maximum === 0 ? 0 : (amounts[index] / maximum) * maximumWidth,
    h: 14,
    color: ['#2563eb', '#f97316', '#16a34a', '#8b5cf6'][index % 4],
  }));
}

export async function createReportPdf(
  request: SaveReportPdfRequest,
): Promise<Uint8Array> {
  const { report } = request;
  const categoryBars = chartBars(
    report.expenses_by_category.map((row) => row.amount),
    280,
  );
  const summaryBars = chartBars([report.income, report.expenses], 280);
  const categoryRows: Content[] = report.expenses_by_category.length
    ? report.expenses_by_category.map((row, index) => ({
        columns: [
          { width: 150, text: row.category_name },
          { width: '*', canvas: [categoryBars[index]] },
          { width: 110, text: `${row.amount} ${report.currency}` },
        ],
        margin: [0, 2, 0, 2],
      }))
    : [{ text: 'Brak wydatków w wybranym zakresie.' }];
  const hiddenNote: Content[] = report.hidden_transactions_included
    ? [
        {
          text: 'W raporcie uwzględniono transakcje ukryte; ich szczegóły nie są ujawniane.',
          italics: true,
          margin: [0, 12, 0, 0],
        },
      ]
    : [];
  const content: Content[] = [
    { text: 'Raport budżetu', style: 'title' },
    {
      text: `Zakres: ${report.period.start} – ${report.period.end}`,
      style: 'subtitle',
    },
    { text: `Waluta podsumowania: ${report.currency}`, margin: [0, 0, 0, 14] },
    {
      table: {
        widths: ['*', '*', '*'],
        body: [
          ['Przychody', 'Wydatki', 'Przepływ netto'],
          [
            `${report.income} ${report.currency}`,
            `${report.expenses} ${report.currency}`,
            `${report.cash_flow} ${report.currency}`,
          ],
        ],
      },
      layout: 'lightHorizontalLines',
      margin: [0, 0, 0, 20],
    },
    { text: 'Przychody i wydatki', style: 'heading' },
    {
      columns: [
        { width: 90, text: 'Przychody' },
        { width: '*', canvas: [summaryBars[0]] },
        { width: 110, text: `${report.income} ${report.currency}` },
      ],
      margin: [0, 2, 0, 2],
    },
    {
      columns: [
        { width: 90, text: 'Wydatki' },
        { width: '*', canvas: [summaryBars[1]] },
        { width: 110, text: `${report.expenses} ${report.currency}` },
      ],
      margin: [0, 2, 0, 14],
    },
    { text: 'Wydatki według kategorii', style: 'heading' },
    ...categoryRows,
    ...hiddenNote,
  ];
  const definition: TDocumentDefinitions = {
    content,
    pageSize: 'A4',
    pageMargins: [40, 48, 40, 48],
    defaultStyle: { font: 'Roboto', fontSize: 10 },
    styles: {
      title: {
        fontSize: 22,
        bold: true,
        color: '#123d66',
        margin: [0, 0, 0, 8],
      },
      subtitle: { fontSize: 12, margin: [0, 0, 0, 6] },
      heading: { fontSize: 14, bold: true, margin: [0, 10, 0, 8] },
    },
    info: {
      title: `Raport budżetu ${report.period.start} – ${report.period.end}`,
      subject: `Podsumowanie w walucie ${report.currency}`,
      creator: 'Income Tracker',
    },
    compress: false,
  };
  return new Uint8Array(await pdfMake.createPdf(definition).getBuffer());
}
