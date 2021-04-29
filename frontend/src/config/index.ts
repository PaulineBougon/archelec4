import { config_default } from "./default";

// Type for the config object
export interface Configuration {
  api_path: string;
  pagination_size: number;
}

const config: Configuration = config_default;

export { config };
