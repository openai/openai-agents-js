import { Agent, tool } from '@openai/agents';
import { z } from 'zod';

const basicExpressionPattern =
  /(-?\d+(?:\.\d+)?)\s*([+\-*/x])\s*(-?\d+(?:\.\d+)?)/;

function evaluateBasicExpression(question: string): string {
  const match = question.match(basicExpressionPattern);
  if (!match) {
    return 'I can only solve a single arithmetic expression such as "2 + 2".';
  }

  const left = Number(match[1]);
  const operator = match[2].toLowerCase();
  const right = Number(match[3]);

  if (operator === '/' && right === 0) {
    return 'Division by zero is undefined.';
  }

  let result: number;
  switch (operator) {
    case '+':
      result = left + right;
      break;
    case '-':
      result = left - right;
      break;
    case '*':
    case 'x':
      result = left * right;
      break;
    default:
      result = left / right;
      break;
  }

  return `${left} ${operator} ${right} = ${result}`;
}

export const calculatorTool = tool({
  name: 'calculator',
  description: 'Use this tool to answer questions about math problems.',
  parameters: z.object({ question: z.string() }),
  execute: async ({ question }) => {
    return evaluateBasicExpression(question);
  },
});

const agent = new Agent({
  name: 'Strict tool user',
  instructions: 'Always answer using the calculator tool.',
  tools: [calculatorTool],
  modelSettings: { toolChoice: 'required' },
});
