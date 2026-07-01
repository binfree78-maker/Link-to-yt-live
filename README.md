# YT Live Link Panel

YouTube video link দিয়ে YouTube Live করার Railway-ready panel.

## Login
Default:
- Username: `admin`
- Password: `admin123`

Railway Variables-এ এগুলো set করুন:
- `PANEL_USER`
- `PANEL_PASS`
- `SESSION_SECRET`

## কাজের Flow
1. GitHub repo তৈরি করুন।
2. এই ফাইলগুলো repo-তে রাখুন।
3. Railway → New Project → Deploy from GitHub repo।
4. Variables দিন: PANEL_USER, PANEL_PASS, SESSION_SECRET
5. Deploy শেষে Railway domain খুলুন।
6. Login করুন।
7. নিজের YouTube video link দিন।
8. YouTube Studio থেকে Stream Key copy করে দিন।
9. Start Live চাপুন।

## Important
- শুধু নিজের ভিডিও ব্যবহার করুন।
- Private / Age restricted / Members-only video অনেক সময় কাজ করবে না।
- 720p recommended।
- Railway resource কম হলে 1080p সমস্যা করতে পারে।
