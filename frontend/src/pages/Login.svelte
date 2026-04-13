<script lang="ts">
  import { login } from '../store/auth';

  let email = '';
  let password = '';
  let error = '';

  function handleLogin() {
    const success = login(email, password);

    if (success) {
      window.location.href = "#/dashboard";
    } else {
      error = "Invalid email or password";
    }
  }
</script>

<div class="min-h-screen flex items-center justify-center bg-blue-100">
  <div class="bg-white p-8 rounded-xl shadow w-80">

    <h1 class="text-xl font-bold mb-4 text-center">
      Login
    </h1>

    {#if error}
      <p class="text-red-500 text-sm">{error}</p>
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
      on:click={handleLogin}
      class="w-full bg-blue-500 text-white py-2 rounded"
    >
      Login
    </button>

    <p class="text-sm text-center mt-3">
      No account?
      <a href="#/signup" class="text-blue-500">Sign up</a>
    </p>

  </div>
</div>