<script>
  import Router from 'svelte-spa-router';
  import Login from './pages/Login.svelte';
  import Signup from './pages/Signup.svelte';
  import Dashboard from './pages/Dashboard.svelte';
  import Chat from './pages/Chat.svelte';
  import Booking from './pages/Booking.svelte';

  const routes = {
    '/': Login,
    '/signup': Signup,
    '/dashboard': Dashboard,
    '/chat': Chat,
    '/booking': Booking
  };
</script>

<Router {routes} />