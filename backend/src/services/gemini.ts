import { GoogleGenerativeAI, SchemaType, Schema } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;

// Gemini client — will be null if no API key is set
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

export interface JournalAnalysisInput {
  journalContent: string;
  languageCode: string;
  moodHistory: Array<{ mood: string; logged_at: string }>;
}

export interface LongitudinalAnalysisInput {
  journalEntries: Array<{ content: string; created_at: string; language_code: string }>;
  moodHistory: Array<{ mood: string; logged_at: string }>;
  dateRangeStart: string;
  dateRangeEnd: string;
}

export interface AIReportResult {
  risk_level: 'low' | 'moderate' | 'high' | 'critical';
  sentiment: 'positive' | 'neutral' | 'negative';
  primary_category: 'academic' | 'personal' | 'grief' | 'career' | 'family' | 'social' | 'health' | 'other';
  longitudinal_pattern: string;
  emotional_markers: string[];
  behavioral_tendencies: string;
  self_harm_detected: 'detected' | 'not_detected';
  suicidal_ideation_detected: 'detected' | 'not_detected';
  specific_triggers: string[];
  immediate_action: string;
  self_help_suggestion: string;
  clinical_goal: string;
  ai_model_version: string;
}

const SYSTEM_PROMPT_SINGLE = `You are a clinical AI assistant for E-MindBridge, a mental health counseling platform.
Analyze the provided journal entry and mood history and return a structured JSON report.
Be accurate. Flag 'high' or 'critical' risk only when there are clear clinical indicators.
Analyze emotions, patterns, triggers, and detect potential self-harm or suicidal ideation.`;

const SYSTEM_PROMPT_LONGITUDINAL = `You are a clinical AI assistant for E-MindBridge.
Analyze the provided longitudinal set of journal entries and mood history over a date range.
Analyze changes, patterns, trends, and clinical indicators over time.`;

const responseSchema: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    risk_level: {
      type: SchemaType.STRING,
      format: "enum",
      enum: ['low', 'moderate', 'high', 'critical'],
      description: "Risk level of the patient based on journal content."
    },
    sentiment: {
      type: SchemaType.STRING,
      format: "enum",
      enum: ['positive', 'neutral', 'negative'],
      description: "Overall sentiment of the entry."
    },
    primary_category: {
      type: SchemaType.STRING,
      format: "enum",
      enum: ['academic', 'personal', 'grief', 'career', 'family', 'social', 'health', 'other'],
      description: "The primary context/theme of the journal entry."
    },
    longitudinal_pattern: {
      type: SchemaType.STRING,
      description: "Mood and behavioral patterns observed."
    },
    emotional_markers: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
      description: "Specific emotional markers detected."
    },
    behavioral_tendencies: {
      type: SchemaType.STRING,
      description: "Inferred behavioral tendencies."
    },
    self_harm_detected: {
      type: SchemaType.STRING,
      format: "enum",
      enum: ['detected', 'not_detected'],
      description: "Flag if self-harm indicators are detected."
    },
    suicidal_ideation_detected: {
      type: SchemaType.STRING,
      format: "enum",
      enum: ['detected', 'not_detected'],
      description: "Flag if suicidal ideation is detected."
    },
    specific_triggers: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
      description: "Specific triggers identified (e.g. stress at school, family issues)."
    },
    immediate_action: {
      type: SchemaType.STRING,
      description: "Clinical immediate recommendation or intervention if necessary."
    },
    self_help_suggestion: {
      type: SchemaType.STRING,
      description: "Actionable self-help suggestion for the patient."
    },
    clinical_goal: {
      type: SchemaType.STRING,
      description: "Suggested clinical goal for the counselor's focus."
    }
  },
  required: [
    'risk_level',
    'sentiment',
    'primary_category',
    'longitudinal_pattern',
    'emotional_markers',
    'behavioral_tendencies',
    'self_harm_detected',
    'suicidal_ideation_detected',
    'specific_triggers',
    'immediate_action',
    'self_help_suggestion',
    'clinical_goal'
  ]
};

/**
 * Analyzes a single journal entry. Uses Gemini if API key is available,
 * otherwise returns a simulated response for development/testing.
 */
export async function analyzeSingleJournal(input: JournalAnalysisInput): Promise<AIReportResult> {
  if (!genAI) {
    // Simulated response when no API key is set
    return simulatedAnalysis();
  }

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: SYSTEM_PROMPT_SINGLE,
  });

  const userMessage = `Journal Entry (language: ${input.languageCode}):
${input.journalContent}

Mood History (last 7 days):
${input.moodHistory.map(m => `- ${m.logged_at}: ${m.mood}`).join('\n')}`;

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: responseSchema,
      temperature: 0.1,
    }
  });

  const responseText = result.response.text();
  const parsed = JSON.parse(responseText);
  return { ...parsed, ai_model_version: 'gemini-2.5-flash' };
}

/**
 * Runs a longitudinal analysis over a date range of entries.
 */
export async function analyzeLongitudinal(input: LongitudinalAnalysisInput): Promise<AIReportResult> {
  if (!genAI) {
    return simulatedAnalysis();
  }

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: SYSTEM_PROMPT_LONGITUDINAL,
  });

  const entriesText = input.journalEntries
    .map(e => `[${e.created_at}] (${e.language_code}): ${e.content}`)
    .join('\n\n');

  const moodText = input.moodHistory
    .map(m => `- ${m.logged_at}: ${m.mood}`)
    .join('\n');

  const userMessage = `Date Range: ${input.dateRangeStart} to ${input.dateRangeEnd}

Journal Entries:
${entriesText}

Mood History:
${moodText}`;

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: responseSchema,
      temperature: 0.1,
    }
  });

  const responseText = result.response.text();
  const parsed = JSON.parse(responseText);
  return { ...parsed, ai_model_version: 'gemini-2.5-flash' };
}

function simulatedAnalysis(): AIReportResult {
  return {
    risk_level: 'low',
    sentiment: 'neutral',
    primary_category: 'personal',
    longitudinal_pattern: '[SIMULATED GEMINI] Consistent mood with minor fluctuations.',
    emotional_markers: ['calm', 'reflective'],
    behavioral_tendencies: '[SIMULATED GEMINI] Regular journaling pattern.',
    self_harm_detected: 'not_detected',
    suicidal_ideation_detected: 'not_detected',
    specific_triggers: [],
    immediate_action: 'None required.',
    self_help_suggestion: 'Continue journaling daily.',
    clinical_goal: 'Maintain current emotional state.',
    ai_model_version: 'simulated-gemini-no-api-key',
  };
}
