/**
 * Metro bundles a global stylesheet imported from a module on web, and ignores
 * it entirely on native — but TypeScript still wants a declaration for the
 * import. `Map.web.tsx` pulls in `leaflet/dist/leaflet.css` this way.
 */
declare module '*.css';
