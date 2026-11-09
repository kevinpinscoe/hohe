import { render } from 'preact';
import { App } from './app';
import { Store } from './store';
import { watchTheme } from './theme';
import { registerServiceWorker } from './update';
import './styles.css';

watchTheme();
const store = new Store();
render(<App store={store} />, document.getElementById('app')!);
void store.start();
void registerServiceWorker();
