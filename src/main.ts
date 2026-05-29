import "@unocss/reset/tailwind.css";
import "tdesign-vue-next/es/style/index.css";
import "virtual:uno.css";
import "./styles/app.css";

import {createPinia} from "pinia";
import {createApp} from "vue";

import App from "./App.vue";

createApp(App)
  .use(createPinia())
  .mount("#app");
