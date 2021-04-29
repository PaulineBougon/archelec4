import { Home } from "../pages/home";
import { Profession } from "../pages/profession";

// Definition of a route
export interface RouteDefinition {
  path: string;
  redirect?: string;
  component?: any;
  exact?: boolean;
  routes?: RouteDefinition[];
}

export const routes: RouteDefinition[] = [
  {
    path: "",
    redirect: "/",
    routes: [
      {
        path: "/",
        component: Home,
      },
      {
        path: "/profession/:id",
        component: Profession,
      },
    ],
  },
];
