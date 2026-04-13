<script lang="ts">
  import { register } from '../store/auth';

  let email = '';
  let password = '';
  let error = '';
  let success = '';

  function handleSignup() {
    const ok = register(email, password);

    if (ok) {
      success = "Account created!";
      error = "";
    } else {
      error = "User already exists";
      success = "";
    }
  }
</script>

<div class="min-h-screen flex items-center justify-center bg-green-100">
  <div class="bg-white p-8 rounded-xl shadow w-80">

    <h1 class="text-xl font-bold mb-4 text-center">
      Sign Up
    </h1>

    {#if error}
      <p class="text-red-500 text-sm">{error}</p>
    {/if}

    {#if success}
      <p class="text-green-500 text-sm">{success}</p>
    {/if}

    <input
      type="email"
      placeholder="Email"
      bind:value={email}
      class="w-full p-2 mb-2 border rounded"
    />

    <input
      type="password"
      placeholder="Password"
      bind:value={password}
      class="w-full p-2 mb-3 border rounded"
    />

    <button
      on:click={handleSignup}
      class="w-full bg-green-500 text-white py-2 rounded"
    >
      Register
    </button>

    <p class="text-sm text-center mt-3">
      Already have an account?
      <a href="#/" class="text-blue-500">Login</a>
    </p>

  </div>
</div>