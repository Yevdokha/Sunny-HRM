// Витягує текст із файлу резюме кандидата, щоб передати його ШІ.
// Підтримує PDF та DOCX (найпоширеніші формати резюме). Для інших форматів
// повертає null — виклик коду сам вирішує, як про це повідомити користувачу.

import mammoth from 'mammoth';

const MAX_CHARS = 8000; // достатньо для аналізу, але не роздуває запит до ШІ

export async function extractCvText(buffer, mime, filename = '') {
  const name = (filename || '').toLowerCase();
  const isPdf = mime === 'application/pdf' || name.endsWith('.pdf');
  const isDocx = mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || name.endsWith('.docx');

  let text = '';
  if (isPdf) {
    const { default: pdfParse } = await import('pdf-parse');
    const result = await pdfParse(buffer);
    text = result.text || '';
  } else if (isDocx) {
    const result = await mammoth.extractRawText({ buffer });
    text = result.value || '';
  } else if (mime === 'text/plain' || name.endsWith('.txt')) {
    text = buffer.toString('utf8');
  } else {
    return null; // непідтримуваний формат
  }

  text = text.replace(/\s+\n/g, '\n').trim();
  if (!text) return '';
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + '\n…(обрізано)' : text;
}
