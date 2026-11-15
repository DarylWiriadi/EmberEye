/**
 * The dashboard's phone layout: the side panel covers the whole screen.
 * Same breakpoint as "Small screens" in components/dashboard/Dashboard.css.
 */
export const PHONE_QUERY = '(max-width: 36rem)';

export const isPhoneLayout = () => window.matchMedia(PHONE_QUERY).matches;
