'use strict';
// Helpers for building annotated lines. See DECISIONS.md #004: every mode reads
// the same line objects, so this is the one place their shape is defined.
//
//   { id, text, explain, concept, blank }
//
//   id       stable identifier used for "viewed" tracking and blank progress
//   text     the literal line as it appears in the file
//   explain  2-4 sentences answering *why* the line is there (null for filler)
//   concept  key from concepts.js, or null
//   links    [{ href, label }] "read more" links, filled in by the generator
//   blank    Mode 2 metadata, or null:
//              template  text with ___ where the user must fill in
//              answer    canonical answer (shown after success)
//              accept    extra acceptable answers (strings or RegExps)
//              hint      shown when the user spends a hint token
//              feedback  [{ match: RegExp, why }] explanations for common wrong answers
//              prompt    short label for the input placeholder

function line(id, text, explain, opts = {}) {
  return { id, text, explain, concept: opts.concept || null, links: opts.links || [], blank: null };
}

// A line with no explanation: blank separators and purely structural YAML.
function raw(text) {
  return { id: null, text, explain: null, concept: null, links: [], blank: null };
}

function blank(id, template, answer, explain, opts = {}) {
  if (!template.includes('___')) throw new Error(`blank ${id}: template must contain ___`);
  return {
    id,
    text: template.replace('___', answer),
    explain,
    concept: opts.concept || null,
    links: opts.links || [],
    blank: {
      template,
      answer,
      accept: opts.accept || [],
      hint: opts.hint || null,
      feedback: opts.feedback || [],
      prompt: opts.prompt || 'fill in',
    },
  };
}

function normalize(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

// Validate a Mode 2 answer. Returns { correct, why }.
// `why` explains the outcome either way so the user learns from both.
function checkBlank(lineObj, value) {
  const b = lineObj.blank;
  const given = normalize(value);
  if (!given) return { correct: false, why: 'Type something first.' };
  const candidates = [b.answer, ...b.accept];
  const correct = candidates.some((c) =>
    c instanceof RegExp ? c.test(given) : normalize(c).toLowerCase() === given.toLowerCase()
  );
  if (correct) return { correct: true, why: lineObj.explain };
  const fb = b.feedback.find((f) => f.match.test(given));
  if (fb) return { correct: false, why: fb.why };
  return {
    correct: false,
    why: 'Not what this line needs. Re-read the surrounding lines: what does this instruction have to refer to for the file to work?',
  };
}

// Render a list of lines to a plain file string.
function toText(lines) {
  return lines.map((l) => l.text).join('\n') + '\n';
}

module.exports = { line, raw, blank, checkBlank, toText, normalize };
