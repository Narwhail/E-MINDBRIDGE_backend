<script lang="ts">
  import { getSession, logout } from '../store/auth';
  import { getMood } from '../store/mood';
  import MoodSelector from '../components/MoodSelector.svelte';

  let mood = getMood();
  let riskLevel = "Low";

  const user = getSession();

  // Protect page
  if (!user) {
    window.location.href = "#/";
  }

  function handleLogout() {
    logout();
    window.location.href = "#/";
  }
  function updateMood(newMood: string) {
  mood = newMood;
}
</script>

<div class="min-h-screen bg-gray-100 p-6">

  <!-- Header -->
  <div class="flex justify-between items-center mb-6">
    <h1 class="text-2xl font-bold text-blue-600">
      E-MindBridge Dashboard
    </h1>
<button 
  on:click={handleLogout}
  class="bg-red-500 text-white px-4 py-2 rounded-lg">
  Logout
</button>
  </div>

  <!-- Cards -->
  <div class="grid grid-cols-1 md:grid-cols-3 gap-4">

    <!-- Mood Card -->
    <div class="bg-white p-5 rounded-xl shadow">
      <h2 class="font-semibold text-gray-600">Today's Mood</h2>
      <div class="text-4xl mt-2">{mood}</div>
      <MoodSelector onSelect={updateMood} />
    </div>

    <!-- AI Risk Level -->
    <div class="bg-white p-5 rounded-xl shadow">
      <h2 class="font-semibold text-gray-600">AI Risk Level</h2>
      <p class="text-2xl mt-2 text-green-500">{riskLevel}</p>
      <p class="text-sm text-gray-400 mt-2">Based on sentiment analysis</p>
    </div>

    <!-- Quick Actions -->
    <div class="bg-white p-5 rounded-xl shadow">
      <h2 class="font-semibold text-gray-600">Quick Actions</h2>

      <button class="w-full mt-3 bg-blue-500 text-white py-2 rounded">
        Chat with BridgeBot
      </button>

      <button class="w-full mt-2 bg-green-500 text-white py-2 rounded">
        Book Counselor
      </button>
    </div>

  </div>

  <!-- Bottom Section -->
  <div class="mt-6 bg-white p-5 rounded-xl shadow">
    <h2 class="font-semibold text-gray-600 mb-2">
      Wellness Insight
    </h2>

    <p class="text-gray-500">
      You are doing okay today. Keep tracking your mood daily to improve AI accuracy.
    </p>
  </div>

</div>