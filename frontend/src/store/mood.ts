const MOOD_KEY = "emindbridge_mood";

// Save mood
export function saveMood(mood: string) {
  localStorage.setItem(MOOD_KEY, mood);
}

// Get mood
export function getMood(): string {
  return localStorage.getItem(MOOD_KEY) || "😐";
}