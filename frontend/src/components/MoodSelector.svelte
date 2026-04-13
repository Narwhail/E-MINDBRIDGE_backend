<script lang="ts">
  import { saveMood } from '../store/mood';

  export let onSelect: (mood: string) => void;

  const moods = ["😢", "😐", "😊", "😁"];

  function selectMood(m: string) {
    saveMood(m);
    onSelect(m);
  }
</script>

<div class="flex justify-between mt-3">
  {#each moods as m}
    <button
      on:click={() => selectMood(m)}
      class="text-3xl hover:scale-125 transition"
    >
      {m}
    </button>
  {/each}
</div>