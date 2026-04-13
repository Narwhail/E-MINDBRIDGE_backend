<script>
  import Router from 'svelte-spa-router';
  import Login from './pages/Login.svelte';
  import Signup from './pages/Signup.svelte';
  import Dashboard from './pages/Dashboard.svelte';

  const routes = {
    '/': Login,
    '/signup': Signup,
    '/dashboard': Dashboard
  };
</script>

<Router {routes} />