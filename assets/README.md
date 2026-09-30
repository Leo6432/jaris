# Logo de Jaris

`jaris-logo.png` : logo fourni par Léo le 30 septembre 2026, fond retiré avec l’outil intégré imagegen (pas de CLI). L’alpha est conservé lors des conversions.

Prompt utilisé :

> Remove the black/navy background from this exact logo. Preserve the exact cyan wavy double orbital outlines, two inner circular rings and central wireframe polyhedron, their geometry and relative placement. Preserve subtle cyan glow with transparent alpha falloff. All negative space including between rings and around the center must be transparent, not a dark filled disk. No redesign, no text, no new elements. Centered square transparent PNG app icon with comfortable transparent margin.

`npm run dist` convertit ce PNG en ICO contenant les tailles 16, 24, 32, 48, 64, 128 et 256 pixels. Le PNG est aussi inclus par electron-vite pour les fenêtres et la barre système.
