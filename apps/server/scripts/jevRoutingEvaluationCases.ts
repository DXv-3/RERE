/**
 * Messages of the kinds people actually open a thread with, and the tier each needs. They are
 * modelled on a real routing log (names and details changed), weighted toward the cases the
 * router got wrong: a report that something is broken read as ordinary work, and a lookup read
 * as hard. Add a case whenever a routed pick is moved back by hand.
 */
export interface JevRoutingEvaluationCase {
  readonly task: string;
  readonly capability: "basic" | "standard" | "advanced" | "unknown";
}

export const jevRoutingEvaluationCases: ReadonlyArray<JevRoutingEvaluationCase> = [
  // Simple: one step, nothing to investigate.
  { task: "what's the capital of France?", capability: "basic" },
  { task: 'Reply with the single word "ok". Do nothing else.', capability: "basic" },
  { task: "How do I undo my last git commit without losing the changes?", capability: "basic" },
  {
    task: "Fix the typo in the homepage hero heading: it says 'Capure' instead of 'Capture'.",
    capability: "basic",
  },
  { task: "Summarize README.md in five bullet points.", capability: "basic" },
  { task: "list the files in the current folder", capability: "basic" },
  // Everyday: bounded, and what to do is already clear.
  {
    task: "Add a dark mode toggle to the settings page and remember the choice.",
    capability: "standard",
  },
  {
    task: "Add a column for phone number to the contacts table and show it on the contact page.",
    capability: "standard",
  },
  {
    task: "Write a 600 word blog post about choosing a wedding photographer.",
    capability: "standard",
  },
  {
    task: "Bump the lodash version in package.json to the latest and run the tests.",
    capability: "standard",
  },
  {
    task: "In a previous session you were helping me reply to supplier emails and filter out the spam. I can't find that session. Are you able to find it in the history?",
    capability: "standard",
  },
  {
    task: "A client from the Harper wedding emailed asking about our referral programme. Where can she get her referral link and what should I tell her?",
    capability: "standard",
  },
  // Hard: the cause or the approach is not yet known.
  {
    task: "Our checkout page is charging some customers twice and I can't work out why. Please find the cause and fix it.",
    capability: "advanced",
  },
  {
    task: "Plan a migration of our auth from sessions to JWT across the web app, mobile app and API.",
    capability: "advanced",
  },
  {
    task: "Review this PR for security problems: https://github.com/acme/app/pull/42",
    capability: "advanced",
  },
  {
    task: "why do i get this error when using Google to sign into our site? On desktop it says I need to set up an authenticator and on my phone it just loops back to the login page",
    capability: "advanced",
  },
  {
    task: "Dana, one of our photographers, said \"I'm noticing a Jordan Lee on my calendar for tomorrow, what is this for?\" Why is it adding projects to her calendar that are not booked? I think these are leads, but they shouldn't show up until they are actually booked, right?",
    capability: "advanced",
  },
  {
    task: "https://example.com/ Looks messed up there's a stray dash right in the home hero section. You have case studies and demos and they're basically the same thing, and the pricing page still shows the old plans.",
    capability: "advanced",
  },
  {
    task: "Why do we have blogs with no cover images? https://example.com/blog or images within the blogs? Also the location guides are VERY weak compared to the rest",
    capability: "advanced",
  },
  {
    task: "I have an applicant who made the changes we asked for and tried to submit them, but he says it still tells him he can't resubmit the application. Could you look into this and see what might be happening?",
    capability: "advanced",
  },
  {
    task: "Why is this agent not working for the job applications? It is supposed to be helping us with an exam but it is having some major issues it looks like",
    capability: "advanced",
  },
  {
    task: "I wanna do a better job at placing review requests in front of our clients at the peak moment. I think when they go to download their images might be it. What do you recommend and can you build it?",
    capability: "advanced",
  },
  {
    task: "A new speech model was just released. I want to analyze whether it is a potential replacement for the voice support agent we have been working on.",
    capability: "advanced",
  },
  {
    task: "I feel like the search on the portal is not working properly. It seems like it is not doing a great job at finding clients and I feel like it can be improved.",
    capability: "advanced",
  },
  {
    task: "Sam our photographer brought a couple of issues to my attention. He has an event this weekend but when he logs in the event is not on his schedule, and his last two payouts show the wrong amount.",
    capability: "advanced",
  },
  // Not a task on its own.
  { task: "try now", capability: "unknown" },
  { task: "okay do it", capability: "unknown" },
  { task: "i think i ran it", capability: "unknown" },
];
