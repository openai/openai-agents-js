// examples/simple-gemini-agent.js
//
// A minimal example showing how to run an AI agent
// with a Gemini (or any OpenAI-compatible) API
// using the @openai/agents SDK.
//

import { Agent, Runner, OpenAIChatCompletionsModel } from '@openai/agents'
import OpenAI from 'openai'

// Environment variables for easy configuration
const BASE_URL = process.env.EXAMPLE_BASE_URL || ''
const API_KEY = process.env.EXAMPLE_API_KEY || ''
const MODEL_NAME = process.env.EXAMPLE_MODEL_NAME || ''

// 🧠 Create a simple OpenAI client for Gemini-compatible API
const client = new OpenAI({
  apiKey: API_KEY, // ✅ safer than hardcoding
  baseURL: BASE_URL,
})

// ⚙️ Create a chat completions model
const model = new OpenAIChatCompletionsModel(client, MODEL_NAME)

// 🚀 Main function
async function main() {
  // Step 1: Create a basic agent
  const agent = new Agent({
    name: 'SimpleAssistant',
    instructions: 'You are a friendly AI that helps answer simple questions.',
  })

  // Step 2: Create a runner to execute the agent
  const runner = new Runner({ model })

  // Step 3: Run the agent with a simple question
  const result = await runner.run(agent, "What's 2 + 2?")

  // Step 4: Output the result
  console.log('AI Output:', result.finalOutput)
}

// Execute the script
main().catch(console.error)
