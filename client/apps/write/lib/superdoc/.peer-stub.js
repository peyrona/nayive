const h = new Proxy(function(){}, { get: () => h, apply: () => h, construct: () => h });
export default h;
export { h as HocuspocusProvider, h as WebsocketProvider, h as Awareness, h as LiveblocksYjsProvider, h as createClient, h as getDocument, h as GlobalWorkerOptions };
