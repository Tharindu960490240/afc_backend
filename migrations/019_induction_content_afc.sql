-- Induction modules written from AFC's own website and published policies (afcollege.edu.au), replacing the starter text.
-- Only modules that still hold the starter text are replaced, so anything staff have already edited is left alone.
-- The text is a draft for AFC to review: every figure comes from the policy named in the module.
UPDATE induction_modules SET body = $$About Australian Federation College
Australian Federation College (AFC) is Learnvault Pty Ltd trading as Australian Federation College. It is a registered training organisation (RTO Code 45616) and is registered to enrol international students (CRICOS Provider No. 03854G).

Campuses
- Melbourne: Level 5, 250 Collins St, Melbourne VIC 3000.
- Launceston: Level 1, 126 Charles St, Launceston, Tasmania 7250.
Contact for both: (+61) 03 6393 3225, info@afcollege.edu.au. Each campus has modern classrooms, a student lounge with kitchen facilities and computers with internet access, and a resources library.

Courses listed on the AFC website
- General English (ELICOS).
- Leadership and Management: BSB50420 Diploma, BSB60420 Advanced Diploma.
- Information Technology: ICT50220 Diploma, ICT60220 Advanced Diploma, with Telecommunications Network Engineering and Cyber Security specialisations.
- Cookery and Hospitality: SIT40521 Certificate IV in Kitchen Management, SIT50422 Diploma, SIT60322 Advanced Diploma of Hospitality Management.
- Human Welfare: CHC43015 Certificate IV in Ageing Support, CHC52025 Diploma of Community Services, CHC62015 Advanced Diploma of Community Sector Management.
- Agriculture: AHC51422 Diploma of Agribusiness Management.
- Construction and Engineering: RII60520 Advanced Diploma of Civil Construction Design.
Which courses run at which campus, and the intake dates, are on each course page and on the Intake Dates page of the website. Check them before you advise a student.

Entry requirements (Student Enrolment and Completion Policy)
- Applicants must meet requirements for language, literacy, numeracy and digital literacy. Numeracy means Year 12 or equivalent.
- There is a course entry interview, and every student completes a digital literacy assessment.
- International students show English proficiency with one of: IELTS 6.0 (no more than 2 years old); at least 5 years of education in an English-speaking country; a Certificate III or IV from an Australian RTO within the last 2 years; or PTE or TOEFL results no more than 2 years old.
- AFC does not currently enrol students under 18.

What you must do
Describe only the courses, campuses and entry requirements that AFC has approved in its current marketing materials. Do not promise a course outcome, a job, a visa or permanent residency.$$
WHERE key = 'courses' AND body LIKE 'STARTER CONTENT%';

UPDATE induction_modules SET body = $$Source: Fees and Refunds Policy and Procedures (AFC-FRPP v3.1). The Offer Letter and Student Agreement is what sets out each student's fees. Never quote a fee that is not in AFC's current documents.

Fees
- The Offer Letter and Student Agreement lists the application fee, tuition and non-tuition fees, the payment schedule and the payment options. It also tells students that fees may change during the course and describes their consumer rights.
- Fees are accepted only with or after the student accepts the Offer Letter and Student Agreement.
- International students are not required to pay more than 50% of the course fees before they start, unless the course is under 26 weeks.
- Payment is by bank transfer by the invoice due date. A student who cannot pay on time must contact AFC before the due date.
- Examples of additional fees: re-assessment $100 per unit (two attempts free during the unit facilitation period); late assessment submission $100 per unit; late payment $20 per week per unpaid instalment; change of course or internal transfer $250; unit re-enrolment $300 per unit; updating a CoE $50; reinstating an enrolment $250. Credit transfer and deferral are nil. The full list is in the policy.

Refunds for international students (summary)
- AFC cancels before the course starts: full refund.
- Student withdraws in writing 60 days or more before the start: 90% of other fees for a study period (term). 28 days or more: 80%. 27 days or less: 70%.
- Student does not start on the agreed date, withdraws after starting, or is cancelled for discipline, a visa breach or incorrect information: no refund of the fees for the current study period or instalment.
- Visa refused and the student has not started: course fees received minus the lesser of 5% of the course fees or $500.
- The application fee is generally not refundable.
- Refunds are paid in AUD to whoever made the original payment, limited to the amount AFC actually received.

How refunds are handled
- The student completes the Refund Application Form within 10 working days of the event. AFC sends its decision in writing within 20 working days, and pays approved refunds within 28 days.
- If AFC cancels, it refunds automatically within 10 working days. No form is needed.
- AFC is a member of the Tuition Protection Scheme, which helps international students finish their studies elsewhere or receive a refund of unspent tuition if AFC cannot deliver the course.

What you must do
Never tell a student a fee is refundable unless the policy says so. Point students to the Offer Letter and Student Agreement and to the full policy on the AFC website.$$
WHERE key = 'fees' AND body LIKE 'STARTER CONTENT%';

UPDATE induction_modules SET body = $$Sources: Attendance Monitoring Policy and Procedures (v3.1), Course Progress Monitoring Policy and Procedures (v3.0) and the Visa and Conditions page of the AFC website.

Student visa conditions
International students must meet attendance and course progress requirements and keep a valid enrolment, only work if their visa permits it, keep approved Overseas Student Health Cover (OSHC), tell AFC of a change of Australian address, phone, email or emergency contacts within 7 days, and finish the course within the duration on their eCoE. A student must normally complete at least 6 months of their principal course with the same provider before moving to another.

Attendance
- Scheduled weekly contact hours at AFC are 20 hours.
- Trainers record attendance every day and attendance is reviewed weekly to find students who are "at risk".
- A student is at risk if they do not attend in the first two weeks of a unit, do not attend regularly or arrive late or leave early, or are absent for more than 5 consecutive days without an approved leave of absence.
- AFC then writes to the student, keeps contacting them until they reply (SMS, email or phone), and holds an intervention meeting. The agreed plan is recorded on an Intervention Form.

Course progress
- Satisfactory progress means completing 50% or more of the course requirements in each study period. A study period is generally one term of 10 weeks, made up of two 5-week study blocks.
- Warning steps: an invitation to an intervention meeting when a student is at risk; a first warning letter if progress is not satisfactory for a study period; a second warning letter if the student does not follow the plan; and a Notice of Intention to Report if progress is unsatisfactory in two consecutive study periods.
- A student can dispute a Notice of Intention to Report through the Complaints and Appeals procedure within 20 working days.
- AFC reports unsatisfactory progress to the Department of Home Affairs through PRISMS only after the internal and external complaint steps are finished or not used. This can lead to the student's visa being cancelled.

What you must do
Explain these requirements to every student before they enrol, so they understand that attendance and progress affect their visa. Encourage students to talk to AFC early if they are struggling. AFC offers one-to-one support, counselling, extra learning resources and a buddy program.$$
WHERE key = 'attendance' AND body LIKE 'STARTER CONTENT%';

UPDATE induction_modules SET body = $$Sources: Complaints and Appeals page and Complaints and Appeals Policy and Procedures (AFC website).

Who can complain or appeal
- A complaint can be about AFC, its trainers, assessors or other staff, another student, or a third party that provides services for AFC, such as an education agent. That includes you.
- An appeal can be about any AFC decision, including an assessment decision.

How it works
1. Informal first: the student is encouraged to talk to the person involved.
2. If that does not resolve it, or the student is not comfortable doing so, the student lodges a written Complaints and Appeals Form, available from reception or the AFC website.
3. Time limits: 30 calendar days from the incident (complaints) or from the decision (appeals).
4. The internal process is free. AFC reviews matters objectively and fairly and gives the student a chance to present their view.
5. If the student wants to appeal externally after the internal decision, they have 5 working days from when they are taken to have received it.

External bodies
- Overseas Students Ombudsman (OSO): free for international students, including for matters such as fees and refunds, attendance and progress, enrolment cancellation, and incorrect advice from an agent.
- National Training Complaints Hotline: 13 38 73 (Monday to Friday, 8am to 6pm), ntch@education.gov.au.
- Australian Skills Quality Authority (ASQA): AFC's registering body. It does not resolve individual disputes.
Students keep their rights under Australian consumer protection law.

What you must do
- Tell every student how to complain and where the form is.
- Pass any complaint or appeal you receive to AFC straight away, in writing. Contact: info@afcollege.edu.au, (+61) 03 6393 3225.
- Never discourage a student from complaining.
- AFC monitors its agents every six months and must investigate any issue raised through that monitoring or student feedback straight away.$$
WHERE key = 'complaints' AND body LIKE 'STARTER CONTENT%';

UPDATE induction_modules SET body = $$Sources: Student Enrolment and Completion Policy and Procedures (v3.0) and the Admission Process page of the AFC website.

What the pre-enrolment information covers
Before a student enrols, they must be told, in the course brochures and the International Student Handbook:
- the CRICOS course code, course content, qualification, modes of study and assessment methods;
- the entry requirements, including the minimum English proficiency;
- the course duration and holiday breaks;
- tuition and non-tuition fees, possible fee changes and the refund policies;
- third-party arrangements;
- the grounds for deferral, suspension or cancellation;
- the link to the ESOS framework;
- information about living in Australia, including indicative costs.

The admission steps
1. The student completes the Application for Enrolment Form and sends it with all supporting documents.
2. AFC assesses the application and sends an acknowledgement with the Pre-enrolment Application Pack. For agent applications the acknowledgement goes to the agent, usually on the same working day, and the pack goes to the student as soon as possible (usually the same working day). An AFC admissions team member then contacts the student about whether the course suits them.
3. If the application succeeds, AFC sends an Offer Letter and Student Agreement. If not, the student is told the outcome and the reasons.
4. The student reads the Offer Letter, Student Agreement and the policies. If they agree, they sign and return them.
5. AFC sends a Tax Invoice for the initial payment. When the payment is received, AFC issues the electronic Confirmation of Enrolment (eCoE), which the student uses to apply for a student visa.
6. AFC emails an orientation invitation and schedule at least one week before the course starts.

What you must do
Students you refer get exactly the same information as students who apply directly. Make sure each student has received the pack and had time to read it before they sign. AFC accepts fees only with or after the student accepts the Offer Letter and Student Agreement.$$
WHERE key = 'preenrolment' AND body LIKE 'STARTER CONTENT%';

UPDATE induction_modules SET body = $$Sources: AFC Education Agents Policy and Procedures (v3.0) and the Student Enrolment and Completion Policy and Procedures.

The law and the Code
The Education Services for Overseas Students (ESOS) Act 2000 and the National Code of Practice for Providers of Education and Training to Overseas Students 2018 protect international students and set the rules AFC must follow. The Code includes requirements for the written agreement with each student (Standard 3) and for working with education agents (Standard 4). AFC must use only agents it has checked, must have a written agreement with each one, and must monitor how they perform. AFC is also registered with ASQA and is a member of the Tuition Protection Scheme.

What AFC requires of its agents
- Act honestly, in good faith, and in the best interests of the student. Keep students' information confidential, and declare in writing and avoid any conflict of interest.
- Have an appropriate understanding of the international education system in Australia.
- Sign and follow the AFC Education Agent Agreement.
- Promote AFC's courses only with AFC's prior written approval, using only approved, up-to-date information and the latest approved marketing materials. Do not change promotional content without approval.
- Tell AFC promptly about any change to your business details or operations.
- Cooperate fully with ASQA and any other regulator, including providing information, taking part in audits or inspections, and giving access to records and communications about marketing and student referrals.
- Submit a commission invoice only when the eligibility conditions in your agreement are met. It must use the approved format, name the student and course, and not include unauthorised incentives, benefits or charges. AFC may withhold, adjust or recover commission if conditions are not met, a refund is issued or a breach is found.

What AFC will not accept
Dishonest recruitment, false or misleading recruitment practices, and unauthorised migration advice. Refusing to cooperate with a regulator is a breach of the agreement and can lead to corrective action, suspension or termination. AFC terminates an agent immediately for false or misleading recruitment.

Why the induction matters
After you finish the six modules you acknowledge the Policies and Procedures. AFC records that acknowledgement, with the date and time, your IP address and the version you read, as its evidence that you were properly briefed.$$
WHERE key = 'esos' AND body LIKE 'STARTER CONTENT%';
