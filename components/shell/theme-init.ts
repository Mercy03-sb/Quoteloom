// Kept out of the "use client" ThemeToggle so the server layout can import it.
export const THEME_KEY = "quoteloom-theme";

/** Runs before paint so a saved choice never flashes the wrong theme. */
export const themeInitScript = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;
