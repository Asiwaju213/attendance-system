import { AuthProvider } from "./app/AuthProvider";
import { AppRoutes } from "./app/routes";

function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}

export default App;