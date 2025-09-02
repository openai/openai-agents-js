import { Agent, run } from '@openai/agents';
import { loadFiles } from './filestore.js';
import { appendFile } from 'fs/promises';
import { z } from 'zod';

console.log('Reading Source Files...');
const files = loadFiles('./');

const vulernabilityAgent = new Agent({
  name: 'Software Developer Assistant',
  instructions:
    'You are a helpful software application security analyst assistant format return data with this javascript JSON structure [{id, title, description }] ',
  outputType: z.object({
    content: z.string(),
  }) as any,
});

const appsecAgent = new Agent({
  name: 'Software Developer Assistant',
  instructions:
    'You are a helpful software application security analyst assistant find OWASP vunerabilities in code',
  outputType: z.object({
    content: z.string(),
    hasVulnerabilities: z.boolean(),
  }) as any,
});

const write = async (data: string, fileName: string) => {
  try {
    if (data) {
      await appendFile(fileName, data);
      process.stdout.write('.');
    }
  } catch (err) {
    console.error(err);
  }
};

const getVunerabilities = async () => {
  const owasp = await run(
    vulernabilityAgent,
    'Return all published application security vunerabilities',
  );

  const json = (owasp as any).finalOutput.content.replace(/\n/g, '');

  return JSON.parse(json);
};

getVunerabilities().then((vunerabilities) => {
  // Compute report file name
  const currentDate = new Date();
  const formattedDateTime =
    currentDate.toISOString().slice(0, 10) +
    '_' +
    currentDate.toTimeString().slice(0, 8);
  const fileName = `./reports/owasp_report_${formattedDateTime}.md`;

  let output = '';

  console.log(
    'Analysing (' + vunerabilities.length + ') OWASP Vunerabilities...',
  );
  vunerabilities.forEach((value: { id: string; title: string }) => {
    files.forEach(async (contents, file) => {
      const findings: any = await run(
        appsecAgent,
        'Find ' +
          value.title +
          ' vunerabilites in this source code file ' +
          file +
          ': ' +
          contents,
      );

      output = findings.finalOutput.content;

      write(output, fileName);

      if (findings.hasVulnerabilities) {
        console.log('Vunerabilities found in ' + file);
      }
    });
  });
});
